all:
	@pnpm exec patchright test --headed tests/main.spec.ts

auth:
	@pnpm exec patchright test --headed tests/auth.setup.ts
