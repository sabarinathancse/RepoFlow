<?php

namespace App\Controllers;

use App\Models\ProductModel;

class ProductController extends BaseController
{
    public function show(string $slug)
    {
        $product = model(ProductModel::class)->where('slug', $slug)->first();
        if (! $product) {
            throw \CodeIgniter\Exceptions\PageNotFoundException::forPageNotFound('No product');
        }
        return view('product', compact('product'));
    }
}
