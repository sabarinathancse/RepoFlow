<?php

namespace App\Controllers;

use App\Models\ProductModel;
use App\Models\EnquiryModel;

class Home extends BaseController
{
    public function index()
    {
        $model = new ProductModel();
        $data['products'] = $model->where('active', 1)->orderBy('name')->findAll();
        $data['title'] = 'Welcome';
        return view('home', $data);
    }

    public function contact()
    {
        if ($this->request->getMethod() === 'POST') {
            if (! $this->validate(['email' => 'required|valid_email'])) {
                return redirect()->back()->withInput();
            }
            $enquiries = new EnquiryModel();
            $enquiries->insert([
                'email'   => $this->request->getPost('email'),
                'message' => $this->request->getPost('message'),
            ]);
            return redirect()->to('/contact')->with('success', 'Thanks!');
        }
        return view('contact', ['title' => 'Contact us']);
    }
}
