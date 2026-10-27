from parser.adapters.paired_columns import PairedColumnsAdapter
from parser.adapters.subgroup_columns import SubgroupColumnsAdapter
from parser.adapters.vertical import VerticalAdapter

_ADAPTERS = {
    "vertical": VerticalAdapter,
    "vertical_parallel": VerticalAdapter,
    "vertical_dates": VerticalAdapter,
    "exam_session": VerticalAdapter,
    "weekly_grid": VerticalAdapter,
    "subgroup_columns": SubgroupColumnsAdapter,
    "paired_columns": PairedColumnsAdapter,
}


def get_adapter(name: str):
    return _ADAPTERS.get(name)
