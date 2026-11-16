#!/usr/bin/python3 -I
"""KakaoTalk commands for the relay Dori, run as the watcher account through one sudo rule.

The relay Dori may list, read, send and mark read, never sign in or out, and never name a file: an upload arrives as
a tar on stdin (built by kakao-client.py from files the relay account itself can read), so no path the watcher
account can read reaches agent-messenger. The watcher's login stays out of the relay Dori's reach, which is what lets
the gate trust the watcher's owner-basis socket by its account."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import BinaryIO, Callable, Sequence

ROOT = "/opt/dori-kakao"
HOME = "/var/lib/dori-kakao"
CLI = ROOT + "/node/bin/agent-messenger"
LOCK = HOME + "/state/kakao.lock"
ALLOWED = {("chat", "list"), ("chat", "leave"), ("message", "list"), ("message", "send"),
           ("message", "mark-read"), ("member", "list")}
ALONE = {"whoami", "help", "--help", "-h", "--version", "-V"}
UPLOAD_VALUE_OPTIONS = {"--mime", "--as", "--account", "--reply-to"}
UPLOAD_FLAGS = {"--pretty"}
MAX_UPLOAD_BYTES = 300 * 1024 * 1024
MAX_UPLOAD_FILES = 30

Runner = Callable[[Sequence[str], dict], int]


def refuse(why: str) -> int:
    print(f"KAKAO_REFUSED {why}", file=sys.stderr)
    return 2


def unpack(stream: BinaryIO, into: str) -> list[str]:
    """Regular files with plain names only, in archive order; anything else refuses the whole upload."""
    paths: list[str] = []
    total = 0
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            name = member.name
            if (not member.isreg() or not name or name != os.path.basename(name) or name in {".", ".."}
                    or name.startswith("-") or "\0" in name):
                raise ValueError(f"upload member {name!r} is not a plain regular file")
            total += member.size
            if len(paths) >= MAX_UPLOAD_FILES or total > MAX_UPLOAD_BYTES:
                raise ValueError("upload too large")
            target = os.path.join(into, name)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"upload member {name!r} has no data")
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                shutil.copyfileobj(source, handle)
            paths.append(target)
    if not paths:
        raise ValueError("upload has no files")
    return paths


def upload_options(args: Sequence[str]) -> tuple[list[str], str]:
    options: list[str] = []
    rest = list(args)
    while rest and rest[0].startswith("-"):
        option = rest.pop(0)
        if option in UPLOAD_FLAGS:
            options.append(option)
        elif option in UPLOAD_VALUE_OPTIONS and rest:
            options += [option, rest.pop(0)]
        else:
            raise ValueError(f"upload option {option!r} is not allowed")
    if len(rest) != 1:
        raise ValueError("upload-tar takes options and one chat id")
    return options, rest[0]


def run(argv: Sequence[str], env: dict) -> int:
    return subprocess.run(list(argv), env=env, check=False).returncode


def main(args: Sequence[str], stdin: BinaryIO, *, cli: str = CLI, lock: str = LOCK, home: str = HOME,
         runner: Runner = run) -> int:
    env = {"HOME": home, "PATH": os.path.dirname(cli) + ":/usr/bin:/bin", "LANG": "C.UTF-8"}
    command = ["flock", lock, cli, "kakaotalk"]
    if len(args) == 1 and args[0] in ALONE:
        return runner([*command, *args], env)
    if tuple(args[:2]) == ("message", "upload-tar"):
        try:
            options, chat = upload_options(args[2:])
            scratch = tempfile.mkdtemp(prefix="upload-", dir=os.path.join(home, "state"))
        except (ValueError, OSError) as error:
            return refuse(str(error))
        try:
            files = unpack(stdin, scratch)
            return runner([*command, "message", "upload", *options, chat, *files], env)
        except (ValueError, OSError, tarfile.TarError) as error:
            return refuse(str(error))
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
    if tuple(args[:2]) not in ALLOWED:
        return refuse(" ".join(args[:2]) or "no command")
    return runner([*command, *args], env)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], sys.stdin.buffer))
