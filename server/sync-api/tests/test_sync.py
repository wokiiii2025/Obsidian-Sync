from app.sync import VectorOrder, compare_vectors


def test_compare_vectors_equal() -> None:
    assert compare_vectors({"a": 1}, {"a": 1}) is VectorOrder.EQUAL


def test_compare_vectors_after() -> None:
    assert compare_vectors({"a": 2, "b": 1}, {"a": 1}) is VectorOrder.AFTER


def test_compare_vectors_before() -> None:
    assert compare_vectors({"a": 1}, {"a": 2, "b": 1}) is VectorOrder.BEFORE


def test_compare_vectors_concurrent() -> None:
    assert compare_vectors({"a": 2, "b": 1}, {"a": 1, "b": 2}) is VectorOrder.CONCURRENT
