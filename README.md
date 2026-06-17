# Playwright ritdon

## usage

Add .env file

```
MY_USERNAME=xxx
MY_PASSWORD=xxx
```

Install dependencies.

```sh
pnpm i

make install
# or
pnpm exec patchright install chromium
```

Run auth.

```sh
make auth

# or

pnpm exec patchright text --head tests/auth.setup.ts
```

Change source files.

```sh
await openBook(page, 19)
```
Download it.

```sh
make

# or

pnpm exec patchright text --head tests/main.spec.ts
```
