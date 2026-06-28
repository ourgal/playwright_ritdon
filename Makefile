DIRS := $(wildcard output/*/)
FILES := $(patsubst %, %temp.md, $(DIRS))
title := titles/titles

all:
	@pnpm exec patchright test --headed tests/main.spec.ts

title:
	@rm $(title).txt
	@pnpm exec patchright test --headed tests/title.spec.ts
	@pwsh -c "cat $(title).txt | sort > $(title)_sorted.txt"

title_zht:
	@rm $(title)_zht.txt
	@pnpm exec patchright test --headed tests/title_zht.spec.ts
	@pwsh -c "cat $(title)_zht.txt | sort > $(title)_zht_sorted.txt"

auth:
	@pnpm exec patchright test --headed tests/auth.setup.ts

install:
	@pnpm exec patchright install chromium

md: ${FILES}

${FILES}:
	pandoc -f html $(dir $@)output.html -t markdown -o $@ --wrap=none
