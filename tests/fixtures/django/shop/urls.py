from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

app_name = 'shop'

router = DefaultRouter()
router.register(r'api/products', views.ProductViewSet)

urlpatterns = [
    path('', views.product_list, name='list'),
    path('<int:pk>/edit/', views.product_edit, name='edit'),
    path('categories/', views.CategoryList.as_view(), name='categories'),
    path('', include(router.urls)),
]
