import os
from pathlib import Path


def read_file(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_init_sh_does_not_use_sudo() -> None:
    """init.sh should not require or invoke sudo at runtime."""
    init_path = "integrations/_infra/init.sh"
    assert os.path.exists(init_path), "init.sh should exist"
    content = read_file(init_path)
    assert "sudo" not in content, "init.sh must not invoke sudo"


def test_dockerfile_no_passwordless_sudo() -> None:
    """Dockerfile must not install sudo or grant passwordless sudoers entries."""
    dockerfile_path = "integrations/_infra/Dockerfile.Deb"
    assert os.path.exists(dockerfile_path), "Dockerfile.Deb should exist"
    content = read_file(dockerfile_path)

    # Should not install sudo package
    assert "sudo" not in content, "Dockerfile must not reference sudo"

    # Should not grant NOPASSWD sudoers entries
    assert "NOPASSWD" not in content, "Dockerfile must not configure passwordless sudo"
