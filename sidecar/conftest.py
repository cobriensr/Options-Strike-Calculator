"""Configure pytest to find source modules in sidecar/src/."""
import sys
from pathlib import Path

# Add sidecar/src/ to Python path so test imports resolve correctly
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
