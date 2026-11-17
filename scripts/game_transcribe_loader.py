"""Import the existing standalone GAME adapter without duplicating its pipeline."""
import importlib.util
from pathlib import Path


def load_game():
    spec = importlib.util.spec_from_file_location("funcuby_game", Path(__file__).with_name("game-transcribe.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
