import os

import uvicorn
from src.api.routes import app  # noqa: F401 — re-exported for uvicorn string reference

if __name__ == "__main__":
    uvicorn.run(
        "src.api.routes:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=False,
    )
