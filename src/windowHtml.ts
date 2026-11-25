function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The page of the demo window. It has no text of its own for the message and the count:
 * the extension sends them as a `state` message.
 */
export function renderWindowHtml(o: {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}): string {
  const nonce = escapeHtml(o.nonce);
  const cspSource = escapeHtml(o.cspSource);
  const scriptUri = escapeHtml(o.scriptUri);
  const styleUri = escapeHtml(o.styleUri);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Demo Window</title>
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<main>
<p id="message" aria-live="polite"></p>
<p aria-live="polite">Clicked: <span id="count"></span></p>
<div class="actions">
<button type="button" id="increment">Click me</button>
<button type="button" id="decrement">Decrement</button>
<button type="button" id="reset">Reset</button>
</div>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
`;
}
