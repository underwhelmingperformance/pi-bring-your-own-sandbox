#!/bin/sh
set -eu
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
case $(uname -m) in
	aarch64) target=arm64 ;;
	x86_64) target=x86 ;;
	*) echo 'This probe requires arm64 or x86-64 Linux.' >&2; exit 1 ;;
esac
if [ "$(id -u)" -eq 0 ]; then
	echo 'Run as the unprivileged fixture owner. Only the loader needs sudo.' >&2
	exit 1
fi

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
clang -g -O2 -target bpf "-D__TARGET_ARCH_$target" \
	-I"/usr/include/$(cc -print-multiarch)" -c "$source_dir/guard.bpf.c" -o guard.bpf.o
bpftool gen skeleton guard.bpf.o > guard.skel.h
cc -O2 -Wall -Wextra -I. "$source_dir/verify.c" -o verify -lbpf -lelf -lz
mkdir workspace
cd workspace
printf 'before\n' > source
printf 'after\n' > save
printf 'pending\n' > next-save
printf 'protected\n' > protected
ln protected alias
sudo ../verify
test "$(cat source)" = after
test "$(cat protected)" = protected
test "$(cat next-save)" = pending
