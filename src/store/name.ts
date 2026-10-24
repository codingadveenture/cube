// The free-text display name people sign Suggestions and shared piles with, kept per device.
const KEY = 'cube.display-name.v1';

export function loadDisplayName(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(KEY, name.trim());
  } catch {
    // Not remembered; it is asked again next time.
  }
}
