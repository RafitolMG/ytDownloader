import uvicorn
from src.api.routes import app  # noqa: F401 — re-exported for uvicorn string reference
# TODO: CONTINUE IMPLEMENTING AUDIO ONLY AND PLAYLIST DOWNLOADS
# TODO: AUTO UPDATE ON MAIN BRANCH PUSH
if __name__ == "__main__":
    uvicorn.run("src.api.routes:app", host="0.0.0.0", port=8000, reload=False)
