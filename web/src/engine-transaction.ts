type Disposable = { free?: () => void };

export async function replaceAfterReady<T extends Disposable>(
  current: T | undefined,
  replacement: T,
  ready: (value: T) => Promise<unknown>,
): Promise<T> {
  try {
    await ready(replacement);
  } catch (error) {
    replacement.free?.();
    throw error;
  }
  current?.free?.();
  return replacement;
}
