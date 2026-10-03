# cnxt-bucket-proxy

Serves a Google Cloud Storage bucket as a cnxt domain on your own machine. It
reads the bucket with your own Google credentials, so cnxt can open anything
you can read, and the bucket needs no CORS or IAM changes.

```
npx github:hartwigmedical/cnxt-bucket-proxy <bucket> [glob]
```

It prints the URL to add in cnxt (Sources → Add → Domain → Add custom domain,
Auth: None):

```
Serving gs://cnxt-reference-data/ as a cnxt domain
  7 datasources, one per prefix matching '*': alphagenome-avi-snv-feature-importances, …
  Reading as you@hartwigmedicalfoundation.nl (Application Default Credentials)

Add it in cnxt as a custom domain:
  Base URL  http://127.0.0.1:3950
  Auth      None
```

## Datasources

| Arguments                  | Datasources                             |
| -------------------------- | --------------------------------------- |
| `my-bucket`                | the whole bucket                        |
| `gs://my-bucket/runs/2024` | everything below `runs/2024/`           |
| `my-bucket '*'`            | one per top-level prefix                |
| `my-bucket 'runs/*'`       | one per prefix below `runs/`            |
| `my-bucket 'runs/COLO*/*'` | one per prefix below each `runs/COLO…/` |

The glob matches whole path segments (`*`, `?`, `[…]`, `{a,b}`), so a
datasource is always a prefix at a fixed depth; `**` is not supported. Quote
it, or your shell expands it. The prefixes are listed again at most once a
minute. Above 200 datasources cnxt gets a search box instead of a list.

## Tables

Every `.parquet`, `.csv`, `.tsv` and `.jsonl` file (the last three optionally
`.gz`) below a datasource is a table, up to 1000 files per datasource. Plain
`.json` is left out because it is mostly metadata. Files below hive-style
partition folders (`scores/chromosome=chr1/data_0.parquet`, …) form a single
table.

Table names come from the file path, without the datasource's own folder name
and without repeated words. `COLO829T/purple/COLO829T.purple.purity.tsv`
becomes `purple_purity` in datasource `COLO829T`, so the same table in
sibling datasources has the same name and cnxt can merge them. Where that
would make two names collide, the full path is used.

## Credentials

The proxy uses Application Default Credentials (`gcloud auth
application-default login`). Without them it falls back to the account
`gcloud auth login` signed in. Files are streamed through the proxy, including
DuckDB's range requests, with your token added. A signed URL would need a
service account key, and you'd read as that service account instead of
yourself.

## Security

Anything that can reach the proxy reads with your credentials, so it:

- listens on 127.0.0.1 only;
- answers only requests addressed to `127.0.0.1`, `localhost` or `[::1]` on
  its own port, which stops DNS rebinding;
- allows CORS only for the known cnxt origins (`--origin` adds more), and
  refuses requests from other origins;
- serves only table files below a datasource.

## Options

- `-p, --port <port>`: default 3950. The base URL in cnxt includes it, so keep
  using the same port for a bucket.
- `-o, --origin <origin>`: allow cnxt at another origin, on top of
  `https://middle-layer-poc.dev.hartwigmedicalfoundation.nl`,
  `http://middle-layer-poc.ingress.pilot-1` and `http://localhost:5173`.
  Repeatable. The proxy logs the origins it refuses.

## Development

```
npm ci
npm run dev -- gs://cnxt-reference-data '*'
npm run check   # typecheck + prettier + vitest
```

`npm run dev` runs the TypeScript directly (Node 24). The published package is
the `dist/` that `npm run build` emits; `prepare` builds it when npm installs
from git.
