"""Host sampling and server identity (app/hostinfo.py): the figures on the System health page and the footer."""

from __future__ import annotations

import subprocess
import sys
import time

import app.hostinfo as H


def test_nvidia_smi_rows_are_parsed():
    text = "0, NVIDIA GeForce RTX 3080 Ti, 10478, 12288, 10, 63\n1, NVIDIA GeForce RTX 3080 Ti, 18, 12288, 0, 51\n"
    gpus = H.parse_nvidia_smi(text)
    assert [g["index"] for g in gpus] == [0, 1]
    assert gpus[0] == {"index": 0, "name": "NVIDIA GeForce RTX 3080 Ti", "memory_used_mb": 10478,
                       "memory_total_mb": 12288, "utilization_percent": 10, "temperature_c": 63}


def test_nvidia_smi_not_available_values_and_noise():
    gpus = H.parse_nvidia_smi("0, Tesla T4, 100, 15360, [N/A], [N/A]\nNVIDIA-SMI has failed\n\n")
    assert len(gpus) == 1 and gpus[0]["utilization_percent"] is None and gpus[0]["temperature_c"] is None


def test_no_nvidia_tool_means_no_gpu_section(monkeypatch):
    def missing(*a, **k):
        raise FileNotFoundError("nvidia-smi")
    monkeypatch.setattr(H.subprocess, "run", missing)
    assert H.read_gpus() == []


def test_server_name_comes_from_env_else_host_name(monkeypatch):
    monkeypatch.setenv("PPE_SERVER_NAME", "dataeaze-office")
    monkeypatch.setenv("PPE_GIT_COMMIT", "abc1234")
    info = H.server_info()
    assert info["name"] == "dataeaze-office" and info["build"] == "abc1234" and info["version"] == H.APP_VERSION
    monkeypatch.delenv("PPE_SERVER_NAME")
    monkeypatch.delenv("PPE_GIT_COMMIT")
    info = H.server_info()
    assert info["name"] and info["build"] is None


def test_app_load_includes_child_processes():
    """ffmpeg runs as a child process: its memory and CPU belong to the app."""
    sampler = H.HostSampler()
    sampler.sample()
    base = sampler._host["process_rss_mb"]
    child = subprocess.Popen([sys.executable, "-c", "x = bytearray(150 * 2**20); import time; time.sleep(8)"])
    try:
        deadline = time.time() + 6
        while time.time() < deadline:
            time.sleep(0.3)
            sampler.sample()
            if sampler._host["process_count"] >= 2 and sampler._host["process_rss_mb"] >= base + 100:
                break
        host = sampler._host
        assert host["process_count"] >= 2
        assert host["process_rss_mb"] >= base + 100  # the child's 150 MB is counted
        assert 0 <= host["process_cpu_percent"] <= 100
        assert host["cpu_count"] >= 1 and 0 <= host["cpu_percent"] <= 100
    finally:
        child.kill()
        child.wait()


def test_readers_return_copies_and_start_once():
    sampler = H.HostSampler()
    first = sampler.host()
    assert "threads" in first
    first["threads"] = -1
    assert sampler.host()["threads"] != -1
    t = sampler._thread
    sampler.host()
    assert sampler._thread is t  # one sampling thread, however many readers
