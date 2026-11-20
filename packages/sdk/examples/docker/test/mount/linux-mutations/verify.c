#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "guard.skel.h"

static int verify_replacements(void)
{
	struct stat before, after;

	if (stat("protected", &before) || before.st_nlink != 2)
		return 1;
	if (rename("save", "source"))
		return 1;
	if (rename("next-save", "alias") != -1 || errno != EPERM)
		return 1;
	if (unlink("alias") != -1 || errno != EPERM)
		return 1;
	if (stat("alias", &after))
		return 1;
	return before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
	       before.st_nlink != after.st_nlink;
}

int main(void)
{
	struct stat fixture;
	if (stat(".", &fixture) || fixture.st_uid == 0)
		return 1;

	struct guard_bpf *guard = guard_bpf__open();
	if (!guard)
		return 1;
	guard->rodata->test_pid = getpid();

	int error = guard_bpf__load(guard);
	if (!error)
		error = guard_bpf__attach(guard);
	if (!error && (setgroups(0, NULL) || setgid(fixture.st_gid) ||
		       setuid(fixture.st_uid) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))) {
		perror("drop fixture privileges");
		error = 1;
	}
	if (!error)
		error = verify_replacements();

	guard_bpf__destroy(guard);
	return error ? 1 : 0;
}
