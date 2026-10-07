<?php

namespace App\Controllers\Admin;

use App\Controllers\BaseController;

class ReportController extends BaseController
{
    public function index()
    {
        $rows = db_connect()->table('orders')->select('status, COUNT(*) as n')->groupBy('status')->get()->getResultArray();
        return $this->response->setJSON($rows);
    }
}
