# Playwright ritdon

## usage

Add `.env` file with environment variables. See [.env](./\.env) for examples.

```dotenv
# Authentication credentials (required)
MY_USERNAME=turf0758
MY_PASSWORD=S6z3*4V0^Om4b5

# Test configuration (optional)
BOOK_INDEX=1
PAGE=
SEARCH_KEYWORD=怪怪
DOWNLOAD_FULL_PAGE=

# CI/CD mode (auto-detected in CI environments)
CI=
```

### Environment Variables

Create a `.env` file in the project root with the following variables:

#### Authentication (Required)
| Variable | Description                  | Example                    |
|----------|------------------------------|----------------------------|
| `MY_USERNAME` | Login username for authentication  | `your_username_here`         |
| `MY_PASSWORD` | Account password for authentication| `your_password_here`       |

These credentials are used to log into [ritdon.com](https://ritdon.com/forum.php) and download ebooks stored in your account. Without valid credentials, authentication tests will fail.

#### Test Configuration (Optional)
| Variable              | Description                                    | Example     | Default   |
|-----------------------|------------------------------------------------|-------------|-----------|
| `BOOK_INDEX`          | Starting book chapter/index to extract         | 0, 1        | 0         |
| `PAGE`                | Page number within each book                   | 0-9999      | 0         |
| `SEARCH_KEYWORD`      | Keyword included in title search               | `怪怪`, `text` |          |
| `DOWNLOAD_FULL_PAGE`  | Flag to download entire pages vs parts only    | `1`, `true` | 0/false   |

These variables control test behavior:
- `BOOK_INDEX` determines which book (by chapter number) to start extracting from each page
- `PAGE` specifies the starting page number within downloaded books  
- `SEARCH_KEYWORD` filters title extraction results by searching for this keyword in the extracted content
- `DOWNLOAD_FULL_PAGE=1` enables downloading complete pages instead of just images

#### CI/CD (Auto-detected)
| Variable | Description                          | Platforms                                          |
|----------|--------------------------------------|---------------------------------------------------|
| `CI`     | Enable CI mode with more retries     | Auto-set to `true` on GitHub Actions, GitLab CI, etc. |

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
