export interface Settings {
  message: string;
  step: number;
  showStatusBar: boolean;
  openLocation: 'tab' | 'beside';
}

export const DEFAULT_MESSAGE = 'Hello from kingofkalk!';
const MIN_STEP = 1;
const MAX_STEP = 100;

/** A whole number is kept and clamped to 1-100; anything else becomes 1. */
function readStep(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_STEP) {
    return MIN_STEP;
  }
  return Math.min(value, MAX_STEP);
}

/** Validates every setting; an invalid value falls back to its default. */
export function readSettings(get: (key: keyof Settings) => unknown): Settings {
  const message = get('message');
  const showStatusBar = get('showStatusBar');
  return {
    message: typeof message === 'string' ? message : DEFAULT_MESSAGE,
    step: readStep(get('step')),
    showStatusBar: typeof showStatusBar === 'boolean' ? showStatusBar : true,
    openLocation: get('openLocation') === 'beside' ? 'beside' : 'tab',
  };
}
