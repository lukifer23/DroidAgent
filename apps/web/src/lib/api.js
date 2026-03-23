export async function api(input, init) {
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
            const json = (await response.json());
            errorText = json.error ?? errorText;
        }
        catch {
            // ignore parse failures
        }
        throw new Error(errorText);
    }
    return (await response.json());
}
export function postJson(input, body) {
    return api(input, {
        method: "POST",
        body: JSON.stringify(body)
    });
}
