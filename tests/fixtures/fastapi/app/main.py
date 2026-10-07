from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import items

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"])
app.include_router(items.router, prefix="/api")


@app.get("/health")
def health():
    return {"ok": True}
