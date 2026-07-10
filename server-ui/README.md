# @chiwanpark/pi-squared-server-ui

SvelteKit-based administration UI for the pi-squared server.

## Development

```sh
pnpm --filter @chiwanpark/pi-squared-server-ui dev
```

The development server is available at `http://localhost:5173` by default.

## Production

```sh
pnpm --filter @chiwanpark/pi-squared-server-ui build
pnpm --filter @chiwanpark/pi-squared-server-ui start
```

The adapter-node production server uses `HOST` and `PORT` for its listen address.
