"""Cost estimation: rates, breakdown, summary roll-up, YAML round-trip.

Pure-logic tests — pricing and cost_report have no Modal dependency at
import (storage is imported lazily inside the write_* helpers), so these
run without a Modal app.
"""

import yaml

from app.common import cost_report, pricing


def test_gpu_rate_substring_match():
    assert pricing.gpu_rate("NVIDIA H200") == pricing.GPU_RATES["H200"]
    assert pricing.gpu_rate("A100-80GB") == pricing.GPU_RATES["A100-80GB"]
    # A100-80GB must win over the bare A100 key (order in the dict)
    assert pricing.gpu_rate("A100-80GB") != pricing.GPU_RATES["A100"]
    assert pricing.gpu_rate(None) is None
    assert pricing.gpu_rate("RTX 9090") is None


def test_estimate_includes_cpu_and_mem():
    c = pricing.estimate_cost(100.0, gpu="L40S", cpu=4, mem_gib=128)
    assert c["gpu_usd"] > 0 and c["cpu_usd"] > 0 and c["mem_usd"] > 0
    assert c["total_usd"] == round(c["gpu_usd"] + c["cpu_usd"] + c["mem_usd"], 6)
    assert c["gpu_unpriced"] is False


def test_cpu_mem_not_rounding_error_at_high_alloc():
    """24c/300G alongside a GPU: CPU+mem must be a material share."""
    c = pricing.estimate_cost(479.0, gpu="H200", cpu=24, mem_gib=300)
    share = (c["cpu_usd"] + c["mem_usd"]) / c["total_usd"]
    assert share > 0.3  # ~47% in practice — never "rounding error"


def test_unknown_gpu_flagged_not_silently_zero():
    c = pricing.estimate_cost(50.0, gpu="RTX 9090", cpu=2, mem_gib=16)
    assert c["gpu_usd"] is None
    assert c["gpu_unpriced"] is True  # surfaced, not hidden


def test_cpu_only_stage_has_no_gpu_cost():
    c = pricing.estimate_cost(45.0, gpu=None, cpu=32, mem_gib=32)
    assert c["gpu_usd"] is None
    assert c["gpu_unpriced"] is False  # no GPU requested → not "unpriced"
    assert c["total_usd"] == round(c["cpu_usd"] + c["mem_usd"], 6)


def _timings():
    def mk(stage, secs, gpu, cpu, mem):
        return {
            "stage": stage,
            "seconds": secs,
            "gpu": gpu,
            "cost": pricing.estimate_cost(secs, gpu=gpu, cpu=cpu, mem_gib=mem),
        }

    return [
        mk("preprocess", 22.0, None, 4, 16),
        mk("video_depth[0:240]", 140.0, "H200", 4, 128),
        mk("video_stereo[m2svid]", 260.0, "A100-80GB", 4, 128),
        mk("encode_mvhevc_x265", 45.0, None, 32, 32),
    ]


def test_summary_rolls_up_and_groups_by_gpu():
    s = cost_report.summarize(_timings())
    expected = round(sum(t["cost"]["total_usd"] for t in _timings()), 6)
    assert s["total_usd"] == expected
    assert s["stage_count"] == 4
    assert set(s["by_gpu_usd"]) == {"H200", "A100-80GB"}
    assert "gpu_unpriced_stages" not in s  # all priced


def test_summary_flags_unpriced_stage():
    t = [{"stage": "x", "seconds": 10.0, "gpu": "RTX 9090",
          "cost": pricing.estimate_cost(10.0, gpu="RTX 9090", cpu=1, mem_gib=4)}]
    s = cost_report.summarize(t)
    assert s["gpu_unpriced_stages"] == ["x"]


def test_yaml_round_trips_through_pyyaml():
    doc = {
        "job_id": "b2a9ee3c7621",
        "stage": "video_depth[0:240]",  # brackets/colon must survive
        "cost": pricing.estimate_cost(140.0, gpu="H200", cpu=4, mem_gib=128),
        "detail": {"input_size": "4K", "note": "has: colon, and #hash"},
        "empty": {},
    }
    back = yaml.safe_load(cost_report.dumps(doc))
    assert back["stage"] == "video_depth[0:240]"
    assert back["cost"]["gpu"] == "H200"
    assert back["cost"]["gpu_unpriced"] is False
    assert back["detail"]["note"] == "has: colon, and #hash"
    assert back["empty"] == {}
