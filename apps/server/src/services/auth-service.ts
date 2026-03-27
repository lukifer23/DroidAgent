import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse
} from "@simplewebauthn/server";
import { and, desc, eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

import { PasskeySummarySchema, nowIso, type CanonicalOrigin } from "@droidagent/shared";

import { db, schema } from "../db/index.js";
import { appStateService } from "./app-state-service.js";
import { accessService } from "./access-service.js";

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

export function resolveRequestOriginInfo(params: {
  requestUrl: string;
  requestOriginHeader?: string | null | undefined;
  canonicalOrigin?: Pick<CanonicalOrigin, "origin" | "rpId"> | null | undefined;
}): RequestOriginInfo {
  if (params.canonicalOrigin) {
    return {
      rpId: params.canonicalOrigin.rpId,
      origin: params.canonicalOrigin.origin
    };
  }

  const origin = params.requestOriginHeader?.trim() ? new URL(params.requestOriginHeader).origin : new URL(params.requestUrl).origin;
  return {
    rpId: new URL(origin).hostname || "localhost",
    origin
  };
}

export function resolveSecureCookieRequirement(params: {
  requestUrl: string;
  requestOriginHeader?: string | null | undefined;
  canonicalOrigin?: Pick<CanonicalOrigin, "origin"> | null | undefined;
}): boolean {
  if (params.canonicalOrigin) {
    return new URL(params.canonicalOrigin.origin).protocol === "https:";
  }

  const origin = params.requestOriginHeader?.trim() ? new URL(params.requestOriginHeader).origin : new URL(params.requestUrl).origin;
  return new URL(origin).protocol === "https:";
}

type ChallengeKind = "registration-owner" | "registration-additional" | "authentication";

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

  private async deleteChallenges(kind: ChallengeKind, userId?: string): Promise<void> {
    const rows = await db.query.authChallenges.findMany({
      where: userId
        ? and(eq(schema.authChallenges.kind, kind), eq(schema.authChallenges.userId, userId))
        : eq(schema.authChallenges.kind, kind)
    });
    for (const row of rows) {
      await db.delete(schema.authChallenges).where(eq(schema.authChallenges.id, row.id));
    }
  }

  private async beginRegistrationForUser(
    user: { id: string; username: string; displayName: string },
    originInfo: RequestOriginInfo,
    kind: Extract<ChallengeKind, "registration-owner" | "registration-additional">
  ) {
    await this.deleteChallenges(kind, user.id);

    const existingPasskeys = await db.query.passkeys.findMany({
      where: eq(schema.passkeys.userId, user.id)
    });

    const options = await generateRegistrationOptions({
      rpName: "DroidAgent",
      rpID: originInfo.rpId,
      userID: new TextEncoder().encode(user.id),
      userName: user.username,
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: existingPasskeys.map((row) => ({
        id: row.credentialId,
        type: "public-key",
        transports: JSON.parse(row.transports) as AuthenticatorTransport[]
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred"
      }
    });

    await db.insert(schema.authChallenges).values({
      id: randomUUID(),
      kind,
      challenge: options.challenge,
      userId: user.id,
      rpId: originInfo.rpId,
      origin: originInfo.origin,
      createdAt: nowIso()
    });

    return options;
  }

  async beginOwnerRegistration(originInfo: RequestOriginInfo) {
    const existingUser = await db.query.users.findFirst();
    if (existingUser) {
      throw new Error("A passkey is already configured for this DroidAgent instance.");
    }

    const user = {
      id: randomUUID(),
      username: "owner",
      displayName: "DroidAgent Owner"
    };

    return await this.beginRegistrationForUser(user, originInfo, "registration-owner");
  }

  async finishOwnerRegistration(c: Context, response: unknown, requireSecureCookie: boolean): Promise<AuthUser> {
    const challengeRow = await db.query.authChallenges.findFirst({
      where: eq(schema.authChallenges.kind, "registration-owner"),
      orderBy: () => [desc(schema.authChallenges.createdAt)]
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
    await this.createSession(c, user.id, requireSecureCookie);
    return user;
  }

  async beginAdditionalPasskeyRegistration(user: AuthUser, originInfo: RequestOriginInfo) {
    return await this.beginRegistrationForUser(user, originInfo, "registration-additional");
  }

  async finishAdditionalPasskeyRegistration(
    c: Context,
    user: AuthUser,
    response: unknown,
    requireSecureCookie: boolean
  ): Promise<AuthUser> {
    const challengeRow = await db.query.authChallenges.findFirst({
      where: and(eq(schema.authChallenges.kind, "registration-additional"), eq(schema.authChallenges.userId, user.id)),
      orderBy: () => [desc(schema.authChallenges.createdAt)]
    });

    if (!challengeRow || !challengeRow.userId) {
      throw new Error("Passkey enrollment was not started for this account.");
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
    await this.createSession(c, user.id, requireSecureCookie);
    return user;
  }

  async beginAuthenticationFromContext(c: Context) {
    const canonicalOrigin = await accessService.assertCanonicalAuthenticatedRequest(c);
    return this.beginAuthentication(
      canonicalOrigin
        ? {
            rpId: canonicalOrigin.rpId,
            origin: canonicalOrigin.origin
          }
        : this.getOriginInfo(c)
    );
  }

  async beginAuthentication(originInfo: RequestOriginInfo) {
    const user = await db.query.users.findFirst();
    if (!user) {
      throw new Error("No passkey is configured yet.");
    }

    const passkeyRows = await db.query.passkeys.findMany({
      where: eq(schema.passkeys.userId, user.id)
    });

    await this.deleteChallenges("authentication", user.id);
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

  async finishAuthentication(c: Context, response: unknown, requireSecureCookie: boolean): Promise<AuthUser> {
    const challengeRow = await db.query.authChallenges.findFirst({
      where: eq(schema.authChallenges.kind, "authentication"),
      orderBy: () => [desc(schema.authChallenges.createdAt)]
    });

    if (!challengeRow || !challengeRow.userId) {
      throw new Error("Authentication was not started for this instance.");
    }

    const credentialId =
      typeof (response as { id?: unknown }).id === "string"
        ? (response as { id: string }).id
        : typeof (response as { rawId?: unknown }).rawId === "string"
          ? (response as { rawId: string }).rawId
          : null;

    if (!credentialId) {
      throw new Error("The authentication response did not include a credential id.");
    }

    const passkeyRow = await db.query.passkeys.findFirst({
      where: and(eq(schema.passkeys.userId, challengeRow.userId), eq(schema.passkeys.credentialId, credentialId))
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
    await this.createSession(c, user.id, requireSecureCookie);
    return user;
  }

  async createSession(c: Context, userId: string, secure: boolean): Promise<void> {
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
      secure,
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

  async listPasskeys(user: AuthUser) {
    const passkeys = await db.query.passkeys.findMany({
      where: eq(schema.passkeys.userId, user.id),
      orderBy: () => [desc(schema.passkeys.createdAt)]
    });

    return passkeys.map((passkey) =>
      PasskeySummarySchema.parse({
        id: passkey.id,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
        deviceType: passkey.deviceType,
        backedUp: passkey.backedUp
      })
    );
  }

  private getOriginInfo(c: Context): RequestOriginInfo {
    return resolveRequestOriginInfo({
      requestUrl: c.req.url,
      requestOriginHeader: c.req.header("origin")
    });
  }

  private requireSecureCookie(c: Context, canonicalOrigin?: Pick<CanonicalOrigin, "origin"> | null): boolean {
    return resolveSecureCookieRequirement({
      requestUrl: c.req.url,
      requestOriginHeader: c.req.header("origin"),
      canonicalOrigin
    });
  }

  async beginRegistration(c: Context): Promise<ReturnType<AuthService["beginOwnerRegistration"]>> {
    const ownerExists = await this.hasUser();
    if (ownerExists) {
      throw new Error("A passkey is already configured. Use sign in instead.");
    }
    const token = new URL(c.req.url).searchParams.get("bootstrap");
    let canonicalOrigin: CanonicalOrigin | null = null;
    if (token) {
      canonicalOrigin = await accessService.assertBootstrapRegistrationRequest(c, token);
    } else {
      await accessService.assertLocalhostBootstrapRequest(c);
    }
    return this.beginOwnerRegistration(
      canonicalOrigin
        ? {
            rpId: canonicalOrigin.rpId,
            origin: canonicalOrigin.origin
          }
        : this.getOriginInfo(c)
    );
  }

  async finishRegistration(c: Context, response: unknown): Promise<AuthUser> {
    const token = new URL(c.req.url).searchParams.get("bootstrap");
    let canonicalOrigin: CanonicalOrigin | null = null;
    if (token) {
      canonicalOrigin = await accessService.assertBootstrapRegistrationRequest(c, token);
      await accessService.consumeBootstrapToken(token);
    } else {
      await accessService.assertLocalhostBootstrapRequest(c);
    }
    return this.finishOwnerRegistration(c, response, this.requireSecureCookie(c, canonicalOrigin));
  }

  async finishAuthenticationFromContext(c: Context, response: unknown): Promise<AuthUser> {
    const canonicalOrigin = await accessService.assertCanonicalAuthenticatedRequest(c);
    return this.finishAuthentication(c, response, this.requireSecureCookie(c, canonicalOrigin));
  }

  async beginAdditionalRegistrationFromContext(c: Context, user: AuthUser) {
    return await this.beginAdditionalPasskeyRegistration(user, this.getOriginInfo(c));
  }

  async finishAdditionalRegistrationFromContext(c: Context, user: AuthUser, response: unknown) {
    return await this.finishAdditionalPasskeyRegistration(c, user, response, this.requireSecureCookie(c));
  }
}

export const authService = new AuthService();
