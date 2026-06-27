DIRS := $(wildcard output/*/)
FILES := $(patsubst %, %temp.md, $(DIRS))

all:
	@pnpm exec patchright test --headed tests/main.spec.ts

title:
	@pnpm exec patchright test --headed tests/title.spec.ts

auth:
	@pnpm exec patchright test --headed tests/auth.setup.ts

install:
	@pnpm exec patchright install chromium

md: ${FILES}

${FILES}:
	pandoc -f html $(dir $@)output.html -t markdown -o $@ --wrap=none
