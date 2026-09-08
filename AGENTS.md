# Agent Guidelines for playwright_riDon Project

## Overview

This repository contains an automated testing suite for **ritdon.com** - a Chinese ISBN/book download service. The project uses `patchright` (Playwright fork) to automate browsing, authentication, and book scraping across multiple pages.

---

## Essential Commands

### Installation & Setup
```bash
pnpm i              # Install dependencies
make install        # Alternative: pnpm exec patchright install chromium
```

### Build & Test
```bash
make all           # Run all tests with patchright
make auth          # Run authentication test only
```

**Direct commands:**
- `pnpm exec patchright test --head tests/main.spec.ts` - Run main test suite
- `pnpm exec patchright text --head tests/auth.setup.ts` - Run auth test
- `pnpm exec patchright install chromium` - Install browser (Windows requires pwsh for sorting output)

---

## Project Purpose & Architecture

### What does this system do?
Automatically downloads ebooks from ritdon.com using a "reading list" style flow:
1. Navigate to `ritdon.com/epub_library.php` 
2. Authenticate with captchas (math problems shown in <p> tags)
3. Extract book titles from each page
4. Click on books one at a time → download full book content (images + HTML)
5. Handle image storage and progress tracking

### Directory Structure
```
playwright_ritdon/
├── tests/                    # Playwright test files
│   ├── auth.setup.ts        # Authentication setup (stored credentials in playwright/.auth/)
│   ├── main.spec.ts         # Main scraping/test flow
│   └── *.spec.ts            # Per-language title extraction tests
├── output/                  # Downloaded book outputs → {title}/{images}/output.html
├── titles/                  # Intermediate text files (sorted + sorted_*.txt)
│   ├── titles.txt           # Extracted English titles
│   ├── titles_zht.txt       # Traditional Chinese characters version
│   └── titles_other.txt     # Other/non-Chinese characters version
├── playwright.config.ts     # Patcher test configuration (600s timeouts!)
├── Makefile                 # Build/test orchestration
├── package.json             # Dev engines uses pnpm v11.2.2
└── .env                     # Required: MY_USERNAME, MY_PASSWORD
```

### Execution Flow
- Tests are defined using `patchright/test` (Playwright-style assertions)
- Uses **setup hooks** in `*.setup.ts` for authentication
- Pages loaded at 600-second timeout (very long - handle network delays!)
- Output format: `{title}/output.html` containing cleaned HTML

---

## Testing Patterns & API

### Key Functions Used

#### Authentication (`auth.setup.ts`)
```typescript
await page.goto('https://ritdon.com/forum.php')
// Fill credentials from environment variables (MY_USERNAME, MY_PASSWORD)
// Captcha: Solve math displayed in <p> element
const answer = "0" or parse two numbers from text and add them
await page.locator("input[name='antispider_captcha']").fill(answer)
await page.click('button.pn.vm')
// Stores auth state to playwright/.auth/user.json
```

#### Main Flow (`main.spec.ts`)
```typescript
const HOME_PAGE = "https://ritdon.com/epub_library.php"
for i in 1..max_pages:
    await switchPage(page, i)           # page-input + 跳转 button
    await loading(page)                 # wait for book covers
    getBookTitles(page, output_file)   # extract div.book-title
```

#### Book Download (`title.spec.ts`)
```typescript
BOOK_INDEX = env.BOOK_INDEX || 0       # default 0 (first book)
await openBook(page, BOOK_INDEX)
# Navigate: book-cover > a
getBookTitle(page, index): string      # div.book-title attribute
# Replace spaces/*?" with _
saveContent(page: Page, title: string): int
    verify(page)                       # antispider captcha on per-book page
    extract base64 images from HTML content
    save to output/{title}/images/<index>.jpg
    return image counter + 1
```

#### Title Extraction (`title_*_spec.ts`)
- Same `verify()` function with math captchas as main test
- Loop through all books on a page
- Append title lines to `.txt` file

---

## Critical Gotchas & Issues

### TypeScript Type Errors
**Most common issues in PRs:**
- `bool` type not recognized → should be `boolean` (line 45+ of main.spec.ts)
- `string | undefined` passing where string required → add `!` or provide default (e.g., `"0"`)
- `process.env.XXX` may be `undefined` → use null coalescing: `MY_USERNAME || "default"`
- `bool` param usage: `(zero: bool) : zero: boolean`

### Environment Dependencies
- `.env` file **required** with `MY_USERNAME` and `MY_PASSWORD`
- Authentication credentials stored in: `playwright/.auth/user.json`
- If `.env` missing → tests fail immediately

### Playwright Configuration Gotchas
- Long timeouts: `timeout: 600000000` (5 minutes - unusually long!)
- Captcha wait times in code: `1200000` ms (12 seconds per captcha)
- `fullyParallel: true` → test files run concurrently
- Browsers: Chromium only enabled (Firefox/WebKit disabled by default)

### Output Handling Notes
- Image saving uses Node.js `fs.promises.writeFile(path, data, 'base64')` callback style (async/await may not work in some cases)
- HTML content cleaning removes: `<meta>`, `<style>`, `<title>`, `<div>` tags
- Each book saved to separate directory: `{book_title}/output.html`

### Makefile Behaviors
- `make title`: Sorts titles alphabetically + sorts into `_sorted.txt`
- Sorting command uses PowerShell: `pwsh -c "cat file | sort > file_sorted"`
- Output paths use forward slashes despite Windows platform (path.join works correctly)

---

## Common Workflow Tasks for New Contributors

### 1. Extract Book Titles Page-by-Page
```bash
# Make sure .env exists with valid credentials
make title           # Runs all title extraction tests

# Then inspect the sorted output
cat titles/titles_sorted.txt
```

### 2. Add a New Test Spec
```typescript
import { expect, test } from 'patchright/test';
// Use same verify() function from title.spec.ts for captcha handling
await page.goto('https://ritdon.com/epub_library.php')
await verify(page)
```

### 3. Test Specific Book Behavior
```typescript
BOOK_INDEX = <book_index> or use environment variable: process.env.BOOK_INDEX
# Can control via makefile args or .env file
```

---

## File-Specific Patterns

### `tests/main.spec.ts`
- Handles multiple pages and page-by-page book iteration
- Extracts titles from `div.book-cover > div.book-title` elements
- Uses regex: `/\d+\/(\d+)/` to find total pages (`1/50`)

### `tests/title.spec.ts`
- Focuses on single-book download flow with image extraction
- Captcha logic in `verify()` function requires understanding of `antispider_captcha` input field

### `playwright.config.ts`
- Reporters: `list` + `html` (never open)
- Trace mode: `on-first-retry` only (not full trace capture)
- Workers and CI settings configured in Makefile

---

## Notes for Debugging

1. **Captcha handling failures** → Increase timeout, check if text extraction regex works
2. **TypeScript errors on lint/typecheck** → Use TS fix command: `pnpm exec patchright fix` (if available) or add type definitions manually
3. **Image save callback errors** → Replace with Promise-based fs methods for reliability
4. **Output directory issues** → Ensure `{title}` names are safe filenames (already sanitized in `getBookTitle`)
