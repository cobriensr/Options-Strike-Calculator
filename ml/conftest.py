"""Configure pytest to find source modules in ml/src/."""
import sys
from pathlib import Path

# Add ml/src/ to Python path so test imports resolve correctly
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
