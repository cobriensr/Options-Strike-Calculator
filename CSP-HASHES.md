# CSP Script-Src Hashes

The `Content-Security-Policy` header in `vercel.json` includes two `sha256-` hashes
that allow inline scripts injected at build time:

| Hash | Script |
|------|--------|
| `sha256-ieoeWczDHkReVBsRBqaal5AFMlBtNjMzgwKvLqi/tSU=` | vite-plugin-pwa service worker registration |
| `sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM=` | Vercel Analytics inline loader |

These **must be regenerated** when `vite-plugin-pwa` or `@vercel/analytics` are upgraded.

## How to regenerate

1. Deploy the updated build
2. Check the browser console for CSP violation errors
3. Hash the blocked script content:

```sh
echo -n '<script content>' | openssl dgst -sha256 -binary | openssl base64
```

4. Replace the old hash in `vercel.json`
