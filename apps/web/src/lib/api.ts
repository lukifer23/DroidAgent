export async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    let errorText = response.statusText;
    try {
      const json = (await response.json()) as { error?: string };
      errorText = json.error ?? errorText;
    } catch {
      // ignore parse failures
    }
    throw new Error(errorText);
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
