#include <linux/bpf.h>
#include <linux/errno.h>
#include <linux/stat.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

struct inode {
	unsigned short i_mode;
	unsigned int i_nlink;
} __attribute__((preserve_access_index));

struct dentry {
	struct inode *d_inode;
} __attribute__((preserve_access_index));

const volatile __u32 test_pid;

static __always_inline int check_entry(struct dentry *entry, int allow_absent)
{
	struct inode *inode;
	unsigned short mode;
	unsigned int links;

	if (bpf_core_read(&inode, sizeof(inode), &entry->d_inode))
		return -EACCES;
	if (!inode)
		return allow_absent ? 0 : -ENOENT;
	if (bpf_core_read(&mode, sizeof(mode), &inode->i_mode) ||
	    bpf_core_read(&links, sizeof(links), &inode->i_nlink))
		return -EACCES;
	return S_ISREG(mode) && links == 1 ? 0 : -EPERM;
}

SEC("fmod_ret/security_inode_rename")
int BPF_PROG(check_rename, struct inode *source_dir, struct dentry *source,
	     struct inode *target_dir, struct dentry *target, unsigned int flags,
	     int previous)
{
	if (previous || bpf_get_current_pid_tgid() >> 32 != test_pid)
		return previous;

	int error = check_entry(source, 0);

	return error ? error : check_entry(target, 1);
}

SEC("fmod_ret/security_inode_unlink")
int BPF_PROG(check_unlink, struct inode *dir, struct dentry *entry, int previous)
{
	if (previous || bpf_get_current_pid_tgid() >> 32 != test_pid)
		return previous;
	return check_entry(entry, 0);
}

char LICENSE[] SEC("license") = "GPL";
