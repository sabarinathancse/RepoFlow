<?php

namespace App\Controllers\Admin;

use App\Controllers\BaseController;
use App\Models\ProductModel;

class ProductController extends BaseController
{
    protected $productModel;

    public function __construct()
    {
        $this->productModel = new ProductModel();
    }

    public function index()
    {
        return view('admin/products', ['products' => $this->productModel->findAll()]);
    }

    public function store()
    {
        $file = $this->request->getFile('image');
        $file->move(FCPATH . 'uploads');
        $this->productModel->save($this->request->getPost());
        return redirect()->to('/admin/products')->with('success', 'Saved');
    }

    public function delete($id)
    {
        $this->productModel->delete($id);
        $db = \Config\Database::connect();
        $db->query("DELETE FROM product_images WHERE product_id = $id");
        return redirect()->back();
    }
}
