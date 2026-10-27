"""A GPU variant must not change the class it came from (2026-10-27: one
4K depth job sent every later 1080p job in its coordinator to B200)."""

import modal
from modal._utils.async_utils import synchronizer

from app.common.modal_options import with_options

app = modal.App("test-modal-options")


@app.cls(gpu="L40S")
class Worker:
    encoder: str = modal.parameter(default="vitl")

    @modal.method()
    def generate(self) -> None:
        pass


def _gpu(obj):
    resources = synchronizer._translate_in(obj)._options.resources
    return resources.gpu_config.gpu_type if resources else None


def _max_containers(obj):
    return synchronizer._translate_in(obj)._options.max_containers


def test_variant_leaves_base_alone():
    b200 = with_options(Worker, gpu="B200")
    assert _gpu(b200) == "B200"
    assert _gpu(Worker) is None
    assert _gpu(Worker(encoder="vitl")) is None


def test_variants_keep_their_own_gpu():
    b200 = with_options(Worker, gpu="B200")
    l40s = with_options(Worker, gpu="L40S")
    assert _gpu(l40s(encoder="vitl")) == "L40S"
    assert _gpu(b200(encoder="vitl")) == "B200"


def test_capping_a_variant_keeps_its_gpu_and_leaves_it_uncapped():
    h200 = with_options(Worker, gpu="H200")
    capped = with_options(h200, max_containers=8)
    assert _gpu(capped) == "H200"
    assert _max_containers(capped) == 8
    assert not _max_containers(h200)


def test_variants_are_cached():
    assert with_options(Worker, gpu="B200") is with_options(Worker, gpu="B200")
