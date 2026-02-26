# Secrets Management (Production)

For production, do not keep Binance keys in plaintext `.env`.

## Recommended approach

1. Create secret files (outside git):

```bash
mkdir -p ./secrets
printf '%s' 'YOUR_BINANCE_API_KEY' > ./secrets/binance_api_key.txt
printf '%s' 'YOUR_BINANCE_API_SECRET' > ./secrets/binance_api_secret.txt
chmod 600 ./secrets/binance_api_key.txt ./secrets/binance_api_secret.txt
```

2. Keep `.env` without plaintext credentials:

```env
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_API_KEY_FILE=/run/secrets/binance_api_key
BINANCE_API_SECRET_FILE=/run/secrets/binance_api_secret
NODE_ENV=production
ALLOW_PLAINTEXT_ENV_SECRETS=false
```

3. Start production stack:

```bash
docker compose -f docker-compose.prod.yml up -d
```

## Runtime enforcement

- `NODE_ENV=production` + `ALLOW_PLAINTEXT_ENV_SECRETS=false` requires `BINANCE_API_KEY_FILE` and `BINANCE_API_SECRET_FILE`.
- Startup fails early if file-backed secrets are missing.

## Preflight

The preflight gate accepts either plain env keys or file-backed keys:

```bash
pnpm run preflight
```
