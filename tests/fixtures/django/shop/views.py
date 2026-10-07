from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render
from django.views.generic import ListView
from rest_framework import viewsets

from .models import Product


def product_list(request):
    products = Product.objects.filter(price__gt=0).order_by('name')
    return render(request, 'shop/list.html', {'products': products})


@login_required
def product_edit(request, pk):
    product = get_object_or_404(Product, pk=pk)
    if request.method == 'POST':
        product.name = request.POST.get('name')
        product.save()
        return redirect('shop:list')
    return render(request, 'shop/edit.html', {'product': product})


class CategoryList(ListView):
    model = Product
    template_name = 'shop/list.html'


class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()
