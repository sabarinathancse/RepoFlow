<?php

use App\Http\Controllers\PostController;
use Illuminate\Support\Facades\Route;

Route::middleware('auth:sanctum')->get('/posts', [PostController::class, 'apiIndex']);
