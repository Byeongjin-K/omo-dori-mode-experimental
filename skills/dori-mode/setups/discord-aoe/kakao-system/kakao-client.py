#!/usr/bin/python3 -I
"""The relay Dori's `kakao` command: every call goes to the watcher account's kakao.py through sudo.

`message upload <chat> <files...>` is read here, with the relay account's own permissions, and sent as a tar on
stdin, so the watcher account never opens a path the relay Dori chose."""
from __future__ import annotations

import os
import stat
import subprocess
import sys
import tarfile
from typing import BinaryIO, Sequence

ACCOUNT = "dori-kakao"
SERVER = "/opt/dori-kakao/bin/kakao"
VALUE_OPTIONS = {"--mime", "--as", "--account", "--reply-to"}


def split_upload(args: Sequence[str]) -> tuple[list[str], str, list[str]]:
    options: list[str] = []
    positional: list[str] = []
    rest = list(args)
    while rest:
        item = rest.pop(0)
        if item in VALUE_OPTIONS and rest:
            options += [item, rest.pop(0)]
        elif item.startswith("--") and "=" in item and item.split("=", 1)[0] in VALUE_OPTIONS:
            name, value = item.split("=", 1)
            options += [name, value]
        elif item.startswith("-"):
            options.append(item)
        else:
            positional.append(item)
    if len(positional) < 2:
        raise ValueError("message upload needs a chat id and at least one file")
    return options, positional[0], positional[1:]


def write_tar(files: Sequence[str], out: BinaryIO) -> None:
    names = [os.path.basename(path) for path in files]
    if len(set(names)) != len(names):
        raise ValueError("two files share a name")
    with tarfile.open(fileobj=out, mode="w|") as archive:
        for path, name in zip(files, names):
            with open(path, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError(f"{path} is not a regular file")
                member = tarfile.TarInfo(name)
                member.size = info.st_size
                member.mode = 0o600
                member.mtime = int(info.st_mtime)
                archive.addfile(member, handle)


def main(args: Sequence[str]) -> int:
    sudo = ["sudo", "-n", "-u", ACCOUNT, SERVER]
    if tuple(args[:2]) != ("message", "upload"):
        os.execvp("sudo", [*sudo, *args])
    try:
        options, chat, files = split_upload(args[2:])
    except ValueError as error:
        print(f"KAKAO_REFUSED {error}", file=sys.stderr)
        return 2
    child = subprocess.Popen([*sudo, "message", "upload-tar", *options, chat], stdin=subprocess.PIPE)
    try:
        assert child.stdin is not None
        write_tar(files, child.stdin)
    except (OSError, ValueError) as error:
        child.kill()
        child.wait()
        print(f"KAKAO_REFUSED {error}", file=sys.stderr)
        return 2
    finally:
        if child.stdin is not None and not child.stdin.closed:
            child.stdin.close()
    return child.wait()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
