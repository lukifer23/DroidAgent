import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

import { nowIso } from "@droidagent/shared";

import { db, schema } from "../db/index.js";
import { appStateService } from "./app-state-service.js";

const SESSION_COOKIE = "droidagent_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function decodeBase64Url(input: string): Uint8Array {
  return Uint8Array.from(Buffer.from(input, "base64url"));
}

function encodeBase64Url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

interface RequestOriginInfo {
  rpId: string;
  origin: string;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

export class AuthService {
  async hasUser(): Promise<boolean> {
    const firstUser = await db.query.users.findFirst();
    return Boolean(firstUser);
  }

  private getOriginInfo(c: Context): RequestOriginInfo {
    const url = new URL(c.req.url);
    const rpId = url.hostname;
    return {
      rpId,
      origin: `${url.protocol}//${url.host}`
    };
  }

  async beginRegistration(c: Context) {
    const existingUser = await db.query.users.findFirst();
    if (existingUser) {
      throw new Error("A passkey is already configured for this DroidAgent instance.");
    }

    const userId = randomUUID();
    const originInfo = this.getOriginInfo(c);
    const options = await generateRegistrationOptions({
      rpName: "DroidAgent",
      rpID: originInfo.rpId,
      userID: new TextEncoder().encode(userId),
      userName: "owner",
      userDisplayName: "DroidAgent Owner",
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred"
      }
    });

    await db.insert(schema.authChallenges).values({
      id: randomUUID(),
      kind: "registration",
      challenge: options.challenge,
      userId,
      rpId: originInfo.rpId,
      origin: originInfo.origin,
      createdAt: nowIso()
    });

    return options;
  }

  async finishRegistration(c: Context, response: unknown): Promise<AuthUser> {
    const challengeRow = await db.query.authChallenges.findFirst({
      where: eq(schema.authChallenges.kind, "registration"),
      orderBy: (challenge, { desc }) => [desc(challenge.createdAt)]
    });

    if (!challengeRow || !challengeRow.userId) {
      throw new Error("Registration was not started for this instance.");
    }

    const verification: VerifiedRegistrationResponse = await verifyRegistrationResponse({
      response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: challengeRow.origin,
      expectedRPID: challengeRow.rpId,
      requireUserVerification: true
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration could not be verified.");
    }

    const user = {
      id: challengeRow.userId,
      username: "owner",
      displayName: "DroidAgent Owner"
    };

    await db.insert(schema.users).values({
      ...user,
      createdAt: nowIso()
    });

    await db.insert(schema.passkeys).values({
      id: randomUUID(),
      userId: user.id,
      credentialId: verification.registrationInfo.credential.id,
      publicKey: encodeBase64Url(verification.registrationInfo.credential.publicKey),
      counter: verification.registrationInfo.credential.counter,
      transports: JSON.stringify(verification.registrationInfo.credential.transports ?? []),
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      createdAt: nowIso(),
      lastUsedAt: null
    });

    await db.delete(schema.authChallenges).where(eq(schema.authChallenges.id, challengeRow.id));
    await appStateService.markSetupStepCompleted("auth", {
      passkeyConfigured: true
    });
    await this.createSession(c, user.id);
    return user;
  }

  async beginAuthentication(c: Context) {
    const user = await db.query.users.findFirst();
    if (!user) {
      throw new Error("No passkey is configured yet.");
    }

    const passkeyRows = await db.query.passkeys.findMany({
      where: eq(schema.passkeys.userId, user.id)
    });

    const originInfo = this.getOriginInfo(c);
    const options = await generateAuthenticationOptions({
      rpID: originInfo.rpId,
      allowCredentials: passkeyRows.map((row) => ({
        id: row.credentialId,
        type: "public-key",
        transports: JSON.parse(row.transports) as AuthenticatorTransport[]
      })),
      userVerification: "preferred"
    });

    await db.insert(schema.authChallenges).values({
      id: randomUUID(),
      kind: "authentication",
      challenge: options.challenge,
      userId: user.id,
      rpId: originInfo.rpId,
      origin: originInfo.origin,
      createdAt: nowIso()
    });

    return options;
  }

  async finishAuthentication(c: Context, response: unknown): Promise<AuthUser> {
    const challengeRow = await db.query.authChallenges.findFirst({
      where: eq(schema.authChallenges.kind, "authentication"),
      orderBy: (challenge, { desc }) => [desc(challenge.createdAt)]
    });

    if (!challengeRow || !challengeRow.userId) {
      throw new Error("Authentication was not started for this instance.");
    }

    const passkeyRow = await db.query.passkeys.findFirst({
      where: eq(schema.passkeys.userId, challengeRow.userId)
    });

    if (!passkeyRow) {
      throw new Error("No registered passkey was found.");
    }

    const verification: VerifiedAuthenticationResponse = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: challengeRow.origin,
      expectedRPID: challengeRow.rpId,
      credential: {
        id: passkeyRow.credentialId,
        publicKey: decodeBase64Url(passkeyRow.publicKey) as Uint8Array<ArrayBuffer>,
        counter: passkeyRow.counter,
        transports: JSON.parse(passkeyRow.transports) as AuthenticatorTransport[]
      },
      requireUserVerification: true
    });

    if (!verification.verified) {
      throw new Error("Passkey authentication could not be verified.");
    }

    await db
      .update(schema.passkeys)
      .set({
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: nowIso()
      })
      .where(eq(schema.passkeys.id, passkeyRow.id));

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, challengeRow.userId)
    });

    if (!user) {
      throw new Error("No matching user record was found.");
    }

    await db.delete(schema.authChallenges).where(eq(schema.authChallenges.id, challengeRow.id));
    await this.createSession(c, user.id);
    return user;
  }

  async createSession(c: Context, userId: string): Promise<void> {
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await db.insert(schema.authSessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashToken(sessionToken),
      expiresAt,
      createdAt: nowIso()
    });

    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: "Strict",
      secure: c.req.url.startsWith("https://"),
      path: "/",
      expires: new Date(expiresAt)
    });
  }

  async clearSession(c: Context): Promise<void> {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      await db.delete(schema.authSessions).where(eq(schema.authSessions.tokenHash, hashToken(token)));
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }

  async getCurrentUser(c: Context): Promise<AuthUser | null> {
    const token = getCookie(c, SESSION_COOKIE);
    return await this.getCurrentUserBySessionToken(token);
  }

  async getCurrentUserBySessionToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token) {
      return null;
    }

    const session = await db.query.authSessions.findFirst({
      where: eq(schema.authSessions.tokenHash, hashToken(token))
    });
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, session.userId)
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName
    };
  }
}

export const authService = new AuthService();
