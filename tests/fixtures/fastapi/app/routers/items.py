from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.models import Item

router = APIRouter(prefix="/items", tags=["items"])


class ItemIn(BaseModel):
    title: str


def get_current_user():
    return None


@router.get("/")
def list_items(db=Depends(lambda: None)):
    return db.query(Item).all()


@router.post("/", status_code=201)
def create_item(payload: ItemIn, user=Depends(get_current_user), db=Depends(lambda: None)):
    item = Item(title=payload.title)
    db.add(item)
    db.commit()
    return item


@router.get("/{item_id}")
def get_item(item_id: int, db=Depends(lambda: None)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    return item
