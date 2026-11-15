DIRS := $(wildcard output/*/)
FILES := $(patsubst %, %temp.md, $(DIRS))
title := titles/titles
args ?=

ifneq ($(wildcard .env),)
	include .env
endif

ifeq ($(HEADLESS),1)
else
	args += --headed
endif

all:
	@pnpm exec patchright test $(args) tests/main.spec.ts

titles: pull title title_zht title_other

title:
	@-rm $(title).txt
	@pnpm exec patchright test $(args) tests/title.spec.ts
	@pwsh -c "cat $(title).txt | sort > $(title)_sorted.txt"

title_zht:
	@-rm $(title)_zht.txt
	@pnpm exec patchright test $(args) tests/title_zht.spec.ts
	@pwsh -c "cat $(title)_zht.txt | sort > $(title)_zht_sorted.txt"

title_other:
	@-rm $(title)_other.txt
	@pnpm exec patchright test $(args) tests/title_other.spec.ts
	@pwsh -c "cat $(title)_other.txt | sort > $(title)_other_sorted.txt"

PHONY: auth
auth:
	@pnpm exec patchright test $(args) tests/auth.setup.ts

PHONY: install
install:
	@pnpm exec patchright install chromium

md: ${FILES}

${FILES}:
	pandoc -f html $(dir $@)output.html -t markdown -o $@ --wrap=none
	perl scripts/md_fixup.pl $@

PHONY: pull
pull:
	@git pull origin

PHONY: metadata
metadata:
	@node scripts/fetch_metadata.mjs $(args)

# Crawl book ids from the real www.wenku8.net (Cloudflare-protected). Needs
# WENKU8_COOKIES in .env (or WENKU8_USERNAME/WENKU8_PASSWORD + a headed browser).
# Uses its own index file - these ids differ from the wowenku.com ones above.
.PHONY: wenku8_net
wenku8_net:
	@node scripts/fetch_wenku8_net_ids.mjs $(args)

wenku8_net_crawl:
	@node scripts/fetch_wenku8_net_ids.mjs --max-pages $(pages) $(args)

# Crawl each matched series' volume list from its wenku8 book page (same auth
# as wenku8_net) into titles/wenku8_net_volumes.json.
.PHONY: wenku8_volumes
wenku8_volumes:
	@node scripts/fetch_wenku8_volumes.mjs $(args)

# Match the ritdon titles (titles/*.txt) against the wenku8.net id index and
# write titles/wenku8_ids.csv. Purely offline, no cookies needed. When
# titles/wenku8_net_volumes.json exists the volume inside the matched series is
# resolved too (wenku8_vol / wenku8_vol_title / wenku8_vol_url / vol_method).
.PHONY: wenku8_ids
wenku8_ids:
	@node scripts/find_wenku8_ids.mjs $(args)

# Fetch 內容簡介 from books.com.tw through FlareSolverr (every volume of each
# series) into titles/intros.json + titles/intros.csv. examples:
#   make intros                          # only series missing from the cache
#   make intros args='--q "圖書迷宮"'     # one title (or isbn), no sweep
#   make intros args='--merge-only'       # rewrite intros.* from the caches, offline
.PHONY: intros
intros:
	@node scripts/fetch_intros.mjs $(args)
