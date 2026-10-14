"use client";

// Browser-only file helpers (no SSR use).

/** Trigger a download of `text` as a file of the given type. */
export function downloadText(fileName: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Trigger a download of `data` as pretty-printed JSON. */
export function downloadJson(fileName: string, data: unknown): void {
  downloadText(fileName, JSON.stringify(data, null, 2), "application/json");
}

/** Fetch a URL and return its body as base64 (no data: prefix), or undefined. */
export async function fetchAsBase64(url: string): Promise<string | undefined> {
  try {
    const blob = await fetch(url).then((r) => r.blob());
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return dataUrl.split(",")[1];
  } catch {
    return undefined;
  }
}
