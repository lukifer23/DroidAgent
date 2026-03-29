export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown
  ) {
    super(message);
  }
}

export async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (!(init?.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    credentials: "include",
    headers,
    ...init
  });

  if (!response.ok) {
    let errorText = response.statusText;
    let payload: unknown = null;
    try {
      const json = (await response.json()) as { error?: string };
      payload = json;
      errorText = json.error ?? errorText;
    } catch {
      // ignore parse failures
    }
    throw new ApiError(errorText, response.status, payload);
  }

  return (await response.json()) as T;
}

export function postJson<T>(input: string, body: unknown): Promise<T> {
  return api<T>(input, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function putJson<T>(input: string, body: unknown): Promise<T> {
  return api<T>(input, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

export function postFormData<T>(input: string, body: FormData): Promise<T> {
  return api<T>(input, {
    method: "POST",
    body,
  });
}

export function deleteJson<T>(input: string): Promise<T> {
  return api<T>(input, {
    method: "DELETE",
  });
}
