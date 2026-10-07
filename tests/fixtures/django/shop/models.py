from django.db import models


class Category(models.Model):
    name = models.CharField(max_length=100)


class Product(models.Model):
    name = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=8, decimal_places=2)
    category = models.ForeignKey(Category, on_delete=models.CASCADE, related_name='products')

    class Meta:
        db_table = 'products'
