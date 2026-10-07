<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use Illuminate\Support\Facades\DB;

class DashboardController extends Controller
{
    public function index()
    {
        $count = DB::table('posts')->count();
        return view('admin.dashboard', compact('count'));
    }
}
