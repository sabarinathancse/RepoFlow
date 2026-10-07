<?php

namespace App\Controllers\Api;

use CodeIgniter\RESTful\ResourceController;

class OrderController extends ResourceController
{
    public function index()
    {
        return $this->respond(db_connect()->table('orders')->get()->getResultArray());
    }

    public function show($id = null)
    {
        return $this->respond(db_connect()->table('orders')->where('id', $id)->get()->getRowArray());
    }
}
