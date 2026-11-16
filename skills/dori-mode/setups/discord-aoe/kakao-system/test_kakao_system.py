from __future__ import annotations

import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = load("kakao_server", "kakao.py")
client = load("kakao_client", "kakao-client.py")


def tar_of(*members: tuple[str, bytes, bytes]) -> io.BytesIO:
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as archive:
        for name, data, kind in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind == tarfile.REGTYPE:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            else:
                info.linkname = data.decode()
                archive.addfile(info)
    out.seek(0)
    return out


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.mkdir(os.path.join(self.home, "state"))
        self.calls: list[tuple[list[str], dict, list[bytes]]] = []

    def runner(self, argv, env):
        files = [Path(a).read_bytes() for a in argv if a.startswith(self.home)]
        self.calls.append((list(argv), env, files))
        return 0

    def call(self, *args: str, stdin: io.BytesIO | None = None) -> int:
        return server.main(list(args), stdin or io.BytesIO(), cli="/x/agent-messenger", lock="/x/kakao.lock",
                           home=self.home, runner=self.runner)

    def test_allowed_commands_pass_through_under_the_lock(self):
        for args in (["message", "send", "100", "hi"], ["chat", "list", "--all"], ["message", "list", "100", "-n", "5"],
                     ["member", "list", "100"], ["message", "mark-read", "100", "7"], ["whoami"]):
            self.assertEqual(self.call(*args), 0)
            self.assertEqual(self.calls[-1][0], ["flock", "/x/kakao.lock", "/x/agent-messenger", "kakaotalk", *args])
            self.assertEqual(self.calls[-1][1]["HOME"], self.home)

    def test_login_logout_and_path_uploads_are_refused(self):
        for args in (["auth", "login"], ["auth", "status"], ["auth", "logout"], ["message", "upload", "100", "/etc/passwd"],
                     ["whoami", "--account", "x"], []):
            self.assertEqual(self.call(*args), 2, args)
        self.assertFalse(self.calls)

    def test_upload_tar_extracts_plain_files_in_order_and_cleans_up(self):
        code = self.call("message", "upload-tar", "--as", "multi", "100",
                         stdin=tar_of(("b.png", b"B", tarfile.REGTYPE), ("a.jpg", b"A", tarfile.REGTYPE)))
        self.assertEqual(code, 0)
        argv, _, files = self.calls[0]
        self.assertEqual(argv[:8], ["flock", "/x/kakao.lock", "/x/agent-messenger", "kakaotalk", "message", "upload",
                                    "--as", "multi"])
        self.assertEqual(argv[8], "100")
        self.assertEqual([os.path.basename(a) for a in argv[9:]], ["b.png", "a.jpg"])
        self.assertEqual(files, [b"B", b"A"])
        self.assertEqual(os.listdir(os.path.join(self.home, "state")), [])

    def test_upload_tar_refuses_links_paths_and_bad_options(self):
        secret = os.path.join(self.home, "secret")
        Path(secret).write_text("token")
        for members in ([("x", secret.encode(), tarfile.SYMTYPE)], [("x", secret.encode(), tarfile.LNKTYPE)],
                        [("../x", b"A", tarfile.REGTYPE)], [("d/x", b"A", tarfile.REGTYPE)],
                        [("-x", b"A", tarfile.REGTYPE)], [("ok", b"A", tarfile.REGTYPE), ("ok", b"B", tarfile.REGTYPE)]):
            self.assertEqual(self.call("message", "upload-tar", "100", stdin=tar_of(*members)), 2, members)
        self.assertEqual(self.call("message", "upload-tar", "--file", "/etc/passwd", "100",
                                   stdin=tar_of(("ok", b"A", tarfile.REGTYPE))), 2)
        self.assertEqual(self.call("message", "upload-tar", stdin=tar_of(("ok", b"A", tarfile.REGTYPE))), 2)
        self.assertFalse(self.calls)
        self.assertEqual(os.listdir(os.path.join(self.home, "state")), [])


class ClientTests(unittest.TestCase):
    def test_split_upload_keeps_options_and_files(self):
        self.assertEqual(client.split_upload(["--as", "multi", "100", "a.png", "--mime=image/png", "b.png"]),
                         (["--as", "multi", "--mime", "image/png"], "100", ["a.png", "b.png"]))
        with self.assertRaises(ValueError):
            client.split_upload(["100"])

    def test_write_tar_reads_regular_files_as_the_caller(self):
        folder = Path(tempfile.mkdtemp())
        (folder / "a.txt").write_bytes(b"alpha")
        out = io.BytesIO()
        client.write_tar([str(folder / "a.txt")], out)
        out.seek(0)
        with tarfile.open(fileobj=out) as archive:
            self.assertEqual([(m.name, m.isreg()) for m in archive.getmembers()], [("a.txt", True)])
        with self.assertRaises(ValueError):
            client.write_tar([str(folder / "a.txt"), str(folder / "a.txt")], io.BytesIO())
        with self.assertRaises((OSError, ValueError)):
            client.write_tar([str(folder)], io.BytesIO())
        with self.assertRaises(OSError):
            client.write_tar([str(folder / "missing")], io.BytesIO())


if __name__ == "__main__":
    unittest.main()
