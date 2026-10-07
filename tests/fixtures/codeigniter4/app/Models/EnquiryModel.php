<?php

namespace App\Models;

use CodeIgniter\Model;

class EnquiryModel extends Model
{
    protected $table = 'enquiries';
    protected $allowedFields = ['email', 'message', 'product_id'];
}
