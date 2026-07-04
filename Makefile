DIRS := $(wildcard output/*/)
FILES := $(patsubst %, %temp.md, $(DIRS))
title := titles/titles

all:
	@pnpm exec patchright test --headed tests/main.spec.ts

titles: pull title title_zht title_other

title:
	@-rm $(title).txt
	@pnpm exec patchright test --headed tests/title.spec.ts
	@pwsh -c "cat $(title).txt | sort > $(title)_sorted.txt"

title_zht:
	@-rm $(title)_zht.txt
	@pnpm exec patchright test --headed tests/title_zht.spec.ts
	@pwsh -c "cat $(title)_zht.txt | sort > $(title)_zht_sorted.txt"

title_other:
	@-rm $(title)_other.txt
	@pnpm exec patchright test --headed tests/title_other.spec.ts
	@pwsh -c "cat $(title)_other.txt | sort > $(title)_other_sorted.txt"

PHONY: auth
auth:
	@pnpm exec patchright test --headed tests/auth.setup.ts

PHONY: install
install:
	@pnpm exec patchright install chromium

md: ${FILES}

${FILES}:
	pandoc -f html $(dir $@)output.html -t markdown -o $@ --wrap=none

PHONY: pull
pull:
	@git pull origin
