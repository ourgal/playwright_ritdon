#!/usr/bin/env perl
# Post-process pandoc's markdown output for a book: inline the span classes
# used by the epub source and drop leftover wrapper attributes.
use strict;
use warnings;

my $file = shift or die "usage: $0 <file>\n";

open my $in, '<:raw', $file or die "$file: $!";
my $s = do { local $/; <$in> };
close $in;

# whitespace cleanup (was done with sed before); a lone "\" becomes an empty
# line, keeping the paragraph break it stood for
$s =~ s/^[ \t]*\r?\n//mg;
$s =~ s/^[ \t]+//mg;
$s =~ s/^\\(\r?\n)/$1/mg;

# tate-chu-yoko / fit-in-width wrappers
$s =~ s/\[([^\[\]]*?)\]\{\.tcy\}/$1/g;
$s =~ s/\((.*?)\)\{\.fit\}/($1)/g;

$s =~ s/\[([^\[\]]+?)\]\{[^}]*\.line-through[^}]*\}/~~$1~~/g;

# gfont / gfont30 / gfont20..., em-dot and any extra classes on the same span.
# Spans can wrap other spans: the wrapper of an already bold inner span is
# dropped instead of bolded again, because markdown cannot nest ** **.
my $emph_attr = qr/\{[^}]*\.(?:gfont\d*|em-dot)[^}]*\}/;
while (1) {
	my $n = 0;
	$n += $s =~ s/\[([^\[\]]*?\*\*[^\[\]]*?)\]$emph_attr/$1/g;
	$n += $s =~ s/\[([^\[\]]+?)\]$emph_attr/**$1**/g;
	last unless $n;
}

# attributes hanging off a link: [text](url){.toc epub:type="toc"}
$s =~ s/(\]\([^)]*\))\{[^}]*\}/$1/g;

# anything else (hfont, kfont, font-0em80, ...): keep the text, drop the wrapper
$s =~ s/\[([^\[\]]*?)\]\{[^}]*\}/$1/g;

open my $out, '>:raw', $file or die "$file: $!";
print $out $s;
close $out;
