from enum import Enum


class VectorOrder(str, Enum):
    BEFORE = "before"
    AFTER = "after"
    EQUAL = "equal"
    CONCURRENT = "concurrent"


def compare_vectors(left: dict[str, int] | None, right: dict[str, int] | None) -> VectorOrder:
    left = left or {}
    right = right or {}
    keys = set(left) | set(right)
    left_greater = False
    right_greater = False

    for key in keys:
        left_value = int(left.get(key, 0))
        right_value = int(right.get(key, 0))
        if left_value > right_value:
            left_greater = True
        elif right_value > left_value:
            right_greater = True

    if left_greater and right_greater:
        return VectorOrder.CONCURRENT
    if left_greater:
        return VectorOrder.AFTER
    if right_greater:
        return VectorOrder.BEFORE
    return VectorOrder.EQUAL
