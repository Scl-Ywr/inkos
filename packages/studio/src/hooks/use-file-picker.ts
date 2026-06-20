import { useState, useCallback } from 'react';

interface FileResult {
  name: string;
  type: string;
  uri: string;
  data?: string;
}

interface PickFileOptions {
  accept?: string;
  multiple?: boolean;
}

export function useFilePicker() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = useCallback(async (options: PickFileOptions = {}): Promise<FileResult[]> => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/__cap_pick_file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept: options.accept, multiple: options.multiple }),
      });
      const json = await resp.json();
      if (json.error === 'cancelled') return [];
      if (json.error) throw new Error(json.error);
      if (!json.uris || json.uris.length === 0) return [];

      return json.uris.map((uri: string, i: number) => ({
        name: json.names?.[i] || 'unknown',
        type: json.types?.[i] || 'application/octet-stream',
        uri,
        data: json.data?.[i] || undefined,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to pick file';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { pickFile, loading, error };
}
