from parser.adapters.paired_columns import PairedColumnsAdapter
from parser.adapters.vertical import VerticalAdapter

_ADAPTERS = {
    "vertical": VerticalAdapter,
    "vertical_parallel": VerticalAdapter,
    "vertical_dates": VerticalAdapter,
    "subgroup_columns": VerticalAdapter,
    "exam_session": VerticalAdapter,
    "weekly_grid": VerticalAdapter,
    "paired_columns": PairedColumnsAdapter,
}


def get_adapter(name: str):
    return _ADAPTERS.get(name)
